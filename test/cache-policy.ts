import assert from "node:assert/strict";
import { graphCacheAgeSeconds, graphCacheEntryIsFresh } from "../src/cache-policy";

const now = 100_000;
assert.equal(graphCacheAgeSeconds(now - 1_999, now), 1);
assert.equal(graphCacheAgeSeconds(now + 1_000, now), 0, "clock skew never reports negative age");
assert.equal(graphCacheEntryIsFresh(now - 60_000, 60, now), true, "TTL boundary is fresh");
assert.equal(graphCacheEntryIsFresh(now - 60_001, 60, now), false, "expired entries rebuild");
assert.equal(graphCacheEntryIsFresh(now, 0, now), false, "zero disables graph caching");
assert.equal(graphCacheEntryIsFresh(Number.NaN, 60, now), false);

console.log("cache-policy OK - age, TTL boundary, expiry, and disabled caching");
