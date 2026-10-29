const assert = require('assert/strict');
const path = require('path');
const core = require(path.resolve(__dirname, '../extension/sync-core.js'));

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ids(doc) {
  return core.normalizeDoc(doc).shortcuts.map(item => item.id);
}

function titles(doc) {
  return core.normalizeDoc(doc).shortcuts.map(item => item.title);
}

function emptyDoc() {
  return core.normalizeDoc({});
}

// ------------------------------------------------------------ order keys

(function testOrderKeys() {
  const random = seededRandom(1);
  const keys = core.generateNKeysBetween(null, null, 50);
  for (let i = 1; i < keys.length; i += 1) assert.ok(keys[i - 1] < keys[i], 'generated keys should be increasing');
  keys.forEach(key => assert.ok(core.isValidPos(key), `key ${key} should be valid`));

  let low = keys[3];
  const high = keys[4];
  for (let i = 0; i < 200; i += 1) {
    const middle = core.keyBetween(low, high, random);
    assert.ok(low < middle && middle < high, `${middle} should sit between ${low} and ${high}`);
    assert.ok(core.isValidPos(middle), `jittered key ${middle} should be valid`);
    low = middle;
  }

  let last = null;
  for (let i = 0; i < 500; i += 1) {
    const next = core.keyBetween(last, null, random);
    if (last) assert.ok(last < next, 'append keys should increase');
    last = next;
  }
  assert.ok(last.length < 12, `500 appends should keep keys short, got ${last.length} chars`);

  let first = 'a0';
  for (let i = 0; i < 300; i += 1) {
    const before = core.keyBetween(null, first, random);
    assert.ok(before < first, 'prepend keys should decrease');
    first = before;
  }

  const tied = [
    { id: 'a', pos: 'a1' },
    { id: 'b', pos: 'a1' },
    { id: 'c', pos: 'a1' },
    { id: 'd', pos: 'a3' },
  ];
  const plan = core.planInsert(tied, 1, random);
  const placed = [
    tied[0],
    { id: 'mover', pos: plan.pos },
    ...tied.slice(1, 3).map(item => ({ ...item, pos: plan.rekey.find(entry => entry.id === item.id).pos })),
    tied[3],
  ];
  assert.deepEqual(core.sortShortcuts(placed).map(item => item.id), ['a', 'mover', 'b', 'c', 'd'], 'insert between equal keys should re-key the items after it');
})();

// ---------------------------------------------------------- scenarios

function makeItem(id, title, url, pos, at, extra = {}) {
  return { id, title, url, size: 'small', icon: null, pos, editedAt: at, movedAt: at, createdAt: at, ...extra };
}

(function testConcurrentAddsAndMoves() {
  const base = core.normalizeDoc({
    shortcuts: [
      makeItem('yt', 'YouTube', 'https://www.youtube.com', 'a0', 10),
      makeItem('gh', 'GitHub', 'https://github.com', 'a1', 10),
      makeItem('x', 'X', 'https://x.com', 'a2', 10),
    ],
  });

  const deviceA = core.normalizeDoc({
    ...base,
    shortcuts: [
      ...base.shortcuts.map(item => (item.id === 'yt' ? { ...item, pos: 'a3', movedAt: 20 } : item)),
      makeItem('bili', 'Bilibili', 'https://www.bilibili.com', 'a4', 21),
    ],
  });
  const deviceB = core.normalizeDoc({
    ...base,
    shortcuts: [
      ...base.shortcuts.map(item => (item.id === 'gh' ? { ...item, title: 'GitHub Work', editedAt: 22 } : item)),
      makeItem('ctrip', '携程', 'https://www.ctrip.com', 'a3V', 23),
    ],
  });

  const ab = core.mergeDocs(deviceA, deviceB);
  const ba = core.mergeDocs(deviceB, deviceA);
  assert.equal(core.canonicalDoc(ab), core.canonicalDoc(ba), 'merge should not depend on order');
  assert.deepEqual(titles(ab), ['GitHub Work', 'X', 'YouTube', '携程', 'Bilibili'], 'move, rename and both additions should all survive');
  assert.ok(core.sameDoc(core.mergeDocs(ab, ab), ab), 'merge should be idempotent');
})();

(function testIconCacheDoesNotWin() {
  // A device that only refreshed its icons must not overwrite a real edit made elsewhere.
  const edited = core.normalizeDoc({ shortcuts: [makeItem('s', 'New name', 'https://example.com', 'a0', 50)] });
  const stale = core.normalizeDoc({ shortcuts: [makeItem('s', 'Old name', 'https://example.com', 'a0', 10)] });
  assert.deepEqual(titles(core.mergeDocs(stale, edited)), ['New name']);
})();

(function testDeletes() {
  const live = core.normalizeDoc({ shortcuts: [makeItem('s', 'Site', 'https://example.com', 'a0', 10)] });
  const deleted = core.normalizeDoc({ tombstones: [{ id: 's', deletedAt: 30 }] });
  assert.deepEqual(ids(core.mergeDocs(live, deleted)), [], 'a delete should beat an older copy');

  const editedLater = core.normalizeDoc({ shortcuts: [makeItem('s', 'Site again', 'https://example.com', 'a0', 40)] });
  assert.deepEqual(titles(core.mergeDocs(deleted, editedLater)), ['Site again'], 'an edit made after the delete keeps the site');
})();

(function testSameAddressFolds() {
  const a = core.normalizeDoc({ shortcuts: [makeItem('a-bili', 'B站', 'https://www.bilibili.com/', 'a0', 10)] });
  const b = core.normalizeDoc({ shortcuts: [makeItem('b-bili', 'Bilibili', 'https://www.bilibili.com', 'a0', 20)] });
  const merged = core.mergeDocs(a, b);
  assert.deepEqual(ids(merged), ['a-bili'], 'the oldest copy should survive');
  assert.deepEqual(titles(merged), ['Bilibili'], 'the newest title should win');
  assert.ok(merged.tombstones.some(tomb => tomb.id === 'b-bili'), 'the folded copy should leave a tombstone');
  assert.ok(core.sameDoc(core.mergeDocs(merged, b), merged), 'seeing the folded copy again should not bring it back');
})();

(function testFoldKeepsEditsMadeElsewhere() {
  // A holds the older copy and moves it; B renames the newer copy of the same
  // address. Whichever computer syncs first, the rename and the move survive.
  const cloud = core.normalizeDoc({ shortcuts: [makeItem('b', 'Old name', 'https://same.example', 'a1', 2)] });
  const a = core.normalizeDoc({ shortcuts: [{ ...makeItem('a', 'Old name', 'https://same.example', 'a5', 1), movedAt: 100 }] });
  const b = core.normalizeDoc({ shortcuts: [{ ...makeItem('b', 'New name', 'https://same.example', 'a1', 2), editedAt: 50 }] });
  const aFirst = core.mergeDocs(b, core.mergeDocs(a, cloud));
  const bFirst = core.mergeDocs(a, core.mergeDocs(b, cloud));
  assert.equal(core.canonicalDoc(aFirst), core.canonicalDoc(bFirst), 'sync order must not change the result');
  assert.deepEqual(titles(aFirst), ['New name'], 'the rename made on the other computer must survive the fold');
  assert.equal(aFirst.shortcuts[0].pos, 'a5', 'the move must survive too');
})();

(function testFoldWithThreeComputers() {
  // B renames and C moves the same shortcut while A holds an older copy of the
  // address. Every sync order ends with the rename and the move.
  const shared = makeItem('b', 'Old', 'https://same.example', 'a1', 20);
  const cloud = core.normalizeDoc({ shortcuts: [shared] });
  const a = core.normalizeDoc({ shortcuts: [makeItem('a', 'Old', 'https://same.example', 'a0', 1)] });
  const b = core.normalizeDoc({ shortcuts: [{ ...shared, title: 'Renamed', editedAt: 50 }] });
  const c = core.normalizeDoc({ shortcuts: [{ ...shared, pos: 'a9', movedAt: 100 }] });
  const orders = [[c, a, b], [b, c, a], [a, b, c], [c, b, a]];
  const results = orders.map(order => order.reduce((doc, device) => core.mergeDocs(device, doc), cloud));
  results.forEach(result => {
    assert.deepEqual(result.shortcuts.map(item => [item.title, item.pos]), [['Renamed', 'a9']], 'rename and move must both survive in any order');
  });
  assert.ok(results.every(result => core.sameDoc(result, results[0])), 'every order must give the same document');
  const deletedEverywhere = core.mergeDocs(results[0], { tombstones: [{ id: 'b', deletedAt: 200 }] });
  assert.equal(deletedEverywhere.shortcuts.length, 0, 'deleting any copy of a website deletes the website');
})();

(function testChangesSinceOnlyChangedParts() {
  // Under "use cloud", a shortcut only moved during the request keeps the
  // cloud title even though the old local title had a newer time.
  const local = core.normalizeDoc({ shortcuts: [{ ...makeItem('s', '本地名', 'https://s.example', 'a0', 100) }] });
  const moved = core.normalizeDoc({ shortcuts: [{ ...makeItem('s', '本地名', 'https://s.example', 'a5', 100), movedAt: 150 }] });
  const cloud = core.normalizeDoc({ shortcuts: [makeItem('s', '云端名', 'https://s.example', 'a0', 50)] });
  const result = core.mergeDocs(cloud, core.changesSince(local, moved));
  assert.deepEqual(result.shortcuts.map(item => [item.title, item.pos]), [['云端名', 'a5']]);
})();

(function testStaleCopyIsNotAChange() {
  // A tab that missed a later edit holds an older copy; it must not count as
  // something new to keep after "use cloud".
  const snapshot = core.normalizeDoc({ shortcuts: [makeItem('a', 'Edited', 'https://a.example', 'a0', 20)], tombstones: [{ id: 'gone', deletedAt: 30 }] });
  const staleTab = core.normalizeDoc({ shortcuts: [makeItem('a', 'Old', 'https://a.example', 'a0', 10), makeItem('gone', 'Gone', 'https://gone.example', 'a1', 5)] });
  const changes = core.changesSince(snapshot, staleTab);
  assert.equal(changes.shortcuts.length, 0, `nothing older than the snapshot may come back, got ${titles(changes)}`);
})();

(function testChangesSince() {
  const before = core.normalizeDoc({ shortcuts: [makeItem('x', 'X', 'https://x.example', 'a0', 10), makeItem('y', 'Y', 'https://y.example', 'a1', 10)] });
  const after = core.normalizeDoc({
    shortcuts: [makeItem('x', 'X', 'https://x.example', 'a0', 10), { ...makeItem('y', 'Y2', 'https://y.example', 'a1', 10), editedAt: 20 }, makeItem('z', 'Z', 'https://z.example', 'a2', 3)],
    tombstones: [{ id: 'gone', deletedAt: 21 }],
  });
  const changes = core.changesSince(before, after);
  assert.deepEqual(ids(changes), ['y', 'z'], 'only changed and new shortcuts count');
  assert.deepEqual(changes.tombstones.map(tomb => tomb.id), ['gone']);
  const cloud = core.normalizeDoc({ settings: { iconDensity: 'large', iconDensityAt: 7 } });
  assert.equal(core.mergeDocs(cloud, changes).settings.iconDensity, 'large', 'unchanged settings must not override the cloud');
})();

(function testDensityDefaults() {
  const untouched = core.normalizeDoc({ settings: { iconDensity: 'small', iconDensityAt: 0 } });
  const migrated = core.normalizeDoc({ settings: { iconDensity: 'medium', iconDensityAt: 0 } });
  assert.equal(core.mergeDocs(untouched, migrated).settings.iconDensity, 'medium', 'a chosen size beats the untouched default');
  assert.equal(core.mergeDocs(migrated, untouched).settings.iconDensity, 'medium');
})();

(function testSettingsAndWallpaper() {
  const a = core.normalizeDoc({ settings: { iconDensity: 'large', iconDensityAt: 30 }, wallpaper: { hash: 'a'.repeat(64), mime: 'image/jpeg', size: 10, updatedAt: 5 } });
  const b = core.normalizeDoc({ settings: { iconDensity: 'medium', iconDensityAt: 20 }, wallpaper: { hash: 'b'.repeat(64), mime: 'image/jpeg', size: 20, updatedAt: 9 } });
  const merged = core.mergeDocs(a, b);
  assert.equal(merged.settings.iconDensity, 'large');
  assert.equal(merged.wallpaper.hash, 'b'.repeat(64));
  const cleared = core.normalizeDoc({ wallpaper: { hash: '', updatedAt: 12 } });
  assert.equal(core.mergeDocs(merged, cleared).wallpaper.hash, '', 'a later wallpaper reset should win');
})();

(function testFirstSyncChoices() {
  const cloud = core.normalizeDoc({
    shortcuts: [
      makeItem('c1', 'Cloud one', 'https://one.example', 'a0', 10),
      makeItem('c2', 'Cloud two', 'https://two.example', 'a1', 10),
    ],
    wallpaper: { hash: 'c'.repeat(64), mime: 'image/jpeg', size: 9, updatedAt: 10 },
  });
  const local = core.normalizeDoc({
    shortcuts: [
      makeItem('l1', 'Local one', 'https://one.example', 'a0', 12),
      makeItem('l3', 'Local three', 'https://three.example', 'a1', 12),
    ],
  });

  const adopted = core.adoptRemote(local, cloud);
  assert.deepEqual(ids(adopted), ['c1', 'c2']);
  assert.equal(adopted.wallpaper.hash, 'c'.repeat(64));

  const summary = core.summarizeDifference(local, cloud);
  assert.deepEqual(summary, { localCount: 2, remoteCount: 2, common: 1, localOnly: 1, remoteOnly: 1, mergedCount: 3 });
  assert.equal(core.mergeDocs(local, cloud).shortcuts.length, 3, 'merge should keep every address once');

  const override = core.overrideRemote(local, cloud, 100);
  assert.deepEqual(ids(override), ['l1', 'l3']);
  // Another computer that already had the cloud copy follows the override.
  const otherComputer = core.mergeDocs(cloud, override);
  assert.deepEqual(titles(otherComputer), ['Local one', 'Local three']);
})();

// ------------------------------------------------------ random devices

function simulate(seed) {
  const random = seededRandom(seed);
  const pick = list => list[Math.floor(random() * list.length)];
  const server = { rev: 0, doc: emptyDoc() };
  let wallClock = 1_000_000;
  const devices = Array.from({ length: 4 }, (_, index) => ({
    name: `d${index}`,
    doc: emptyDoc(),
    clock: 0,
    skew: Math.floor(random() * 4000) - 2000,
  }));

  const now = device => {
    wallClock += 1 + Math.floor(random() * 50);
    device.clock = Math.max(wallClock + device.skew, device.clock + 1);
    return device.clock;
  };

  const urls = Array.from({ length: 14 }, (_, index) => `https://site-${index}.example`);
  let counter = 0;

  const operations = {
    add(device) {
      const list = device.doc.shortcuts;
      const at = Math.floor(random() * (list.length + 1));
      const { pos } = core.planInsert(list, at, random);
      const stamp = now(device);
      counter += 1;
      device.doc = core.normalizeDoc({
        ...device.doc,
        shortcuts: [...list, makeItem(`${device.name}-${counter}`, `Site ${counter}`, pick(urls), pos, stamp)],
      });
    },
    edit(device) {
      if (!device.doc.shortcuts.length) return;
      const target = pick(device.doc.shortcuts);
      const stamp = now(device);
      device.doc = core.normalizeDoc({
        ...device.doc,
        shortcuts: device.doc.shortcuts.map(item => (item.id === target.id
          ? { ...item, title: `${item.title}*`, size: pick(core.SIZES), editedAt: stamp }
          : item)),
      });
    },
    move(device) {
      const list = device.doc.shortcuts;
      if (list.length < 2) return;
      const target = pick(list);
      const rest = list.filter(item => item.id !== target.id);
      const plan = core.planInsert(rest, Math.floor(random() * (rest.length + 1)), random);
      const stamp = now(device);
      const rekey = new Map(plan.rekey.map(entry => [entry.id, entry.pos]));
      device.doc = core.normalizeDoc({
        ...device.doc,
        shortcuts: list.map(item => {
          if (item.id === target.id) return { ...item, pos: plan.pos, movedAt: stamp };
          if (rekey.has(item.id)) return { ...item, pos: rekey.get(item.id), movedAt: stamp };
          return item;
        }),
      });
    },
    remove(device) {
      if (!device.doc.shortcuts.length) return;
      const target = pick(device.doc.shortcuts);
      const stamp = now(device);
      device.doc = core.normalizeDoc({
        ...device.doc,
        shortcuts: device.doc.shortcuts.filter(item => item.id !== target.id),
        tombstones: [...device.doc.tombstones, { id: target.id, deletedAt: stamp }],
      });
    },
    density(device) {
      device.doc = core.normalizeDoc({ ...device.doc, settings: { iconDensity: pick(core.SIZES), iconDensityAt: now(device) } });
    },
    wallpaper(device) {
      const hash = random() < 0.2 ? '' : pick(['a', 'b', 'c']).repeat(64);
      device.doc = core.normalizeDoc({ ...device.doc, wallpaper: { hash, mime: 'image/jpeg', size: 1, updatedAt: now(device) } });
    },
    sync(device) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const seenRev = server.rev;
        const remote = server.doc;
        const merged = core.mergeDocs(device.doc, remote);
        device.clock = Math.max(device.clock, core.maxTimestamp(remote));
        // Another device may write between our read and our write.
        if (random() < 0.15) operations.sync(pick(devices.filter(other => other !== device)));
        if (!core.sameDoc(merged, remote)) {
          if (server.rev !== seenRev) continue; // compare-and-swap failed, retry
          server.rev += 1;
          server.doc = merged;
        }
        device.doc = core.mergeDocs(device.doc, merged);
        return;
      }
    },
  };

  const weighted = ['add', 'add', 'add', 'edit', 'edit', 'move', 'move', 'remove', 'density', 'wallpaper', 'sync', 'sync', 'sync'];
  for (let step = 0; step < 400; step += 1) operations[pick(weighted)](pick(devices));
  for (let round = 0; round < 3; round += 1) devices.forEach(device => operations.sync(device));

  const expected = core.canonicalDoc(server.doc);
  devices.forEach(device => {
    assert.equal(core.canonicalDoc(device.doc), expected, `seed ${seed}: ${device.name} should match the server after syncing`);
  });
  const keys = server.doc.shortcuts.map(item => core.urlKey(item.url));
  assert.equal(new Set(keys).size, keys.length, `seed ${seed}: no address should appear twice`);
  return server.doc.shortcuts.length;
}

let totalShortcuts = 0;
for (let seed = 1; seed <= 150; seed += 1) totalShortcuts += simulate(seed);

console.log(JSON.stringify({
  orderKeys: 'ok',
  scenarios: 'ok',
  randomRuns: 150,
  averageFinalShortcuts: Math.round(totalShortcuts / 150),
}, null, 2));
