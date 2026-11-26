(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.ZX = root.ZX || {};
    root.ZX.localOverlayStore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DB_NAME = 'nova-local-overlay';
  var DB_VERSION = 1;
  var STORE_NAME = 'overlay';
  var RECORD_KEY = 'current';

  function databaseFor(scope) {
    if (scope && scope.indexedDB) return scope.indexedDB;
    return typeof indexedDB !== 'undefined' ? indexedDB : null;
  }

  function available(scope) {
    return !!databaseFor(scope);
  }

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB request failed')); };
    });
  }

  function openDatabase(scope) {
    var idb = databaseFor(scope);
    if (!idb) return Promise.reject(new Error('IndexedDB unavailable'));
    var request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = function () {
      var db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    return requestResult(request).then(function (db) {
      db.onversionchange = function () { db.close(); };
      return db;
    });
  }

  function sameRecord(left, right) {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.overlay === right.overlay && left.trash === right.trash &&
      left.revision === right.revision && left.updatedAt === right.updatedAt;
  }

  function read(scope) {
    if (!available(scope)) return Promise.resolve(null);
    return openDatabase(scope).then(function (db) {
      return new Promise(function (resolve, reject) {
        var outcome = null;
        var tx = db.transaction(STORE_NAME, 'readonly');
        var request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
        request.onsuccess = function () { outcome = request.result || null; };
        tx.oncomplete = function () {
          db.close();
          resolve(outcome);
        };
        tx.onabort = function () {
          db.close();
          reject(tx.error || new Error('IndexedDB read aborted'));
        };
        tx.onerror = function () {
          db.close();
          reject(tx.error || new Error('IndexedDB read failed'));
        };
      });
    });
  }

  function commit(scope, expected, changes) {
    if (!available(scope)) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
      return Promise.reject(new TypeError('changes must be an object'));
    }
    if (Object.keys(changes).some(function (key) { return key !== 'overlay' && key !== 'trash'; })) {
      return Promise.reject(new TypeError('unsupported overlay store field'));
    }
    if ((changes.overlay !== undefined && changes.overlay !== null && typeof changes.overlay !== 'string') ||
        (changes.trash !== undefined && changes.trash !== null && typeof changes.trash !== 'string')) {
      return Promise.reject(new TypeError('overlay and trash must be strings or null'));
    }
    return openDatabase(scope).then(function (db) {
      return new Promise(function (resolve, reject) {
        var outcome = null;
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        var request = store.get(RECORD_KEY);
        request.onsuccess = function () {
          var current = request.result || null;
          if (!sameRecord(current, expected)) {
            outcome = { status: 'conflict', current: current };
            return;
          }
          var next = {
            overlay: current ? current.overlay : null,
            trash: current ? current.trash : null,
            revision: current && Number.isSafeInteger(current.revision) ? current.revision + 1 : 1,
            updatedAt: Date.now()
          };
          if (Object.prototype.hasOwnProperty.call(changes, 'overlay')) next.overlay = changes.overlay;
          if (Object.prototype.hasOwnProperty.call(changes, 'trash')) next.trash = changes.trash;
          store.put(next, RECORD_KEY);
          outcome = { status: 'committed', current: next };
        };
        tx.oncomplete = function () {
          db.close();
          resolve(outcome);
        };
        tx.onabort = function () {
          db.close();
          reject(tx.error || new Error('IndexedDB commit aborted'));
        };
        tx.onerror = function () {
          db.close();
          reject(tx.error || new Error('IndexedDB commit failed'));
        };
      });
    });
  }

  return {
    available: available,
    read: read,
    commit: commit
  };
});
