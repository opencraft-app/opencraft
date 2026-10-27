// Curated standard ECMAScript shims, installed once per renderer realm before
// application or product modules evaluate. core-js feature-detects native support.
// Keep DOM/device capabilities behind their existing adapters, not global shims.
import "core-js/es/iterator/index.js";
import "core-js/es/promise/with-resolvers.js";
import "core-js/es/object/group-by.js";
import "core-js/es/map/group-by.js";
import "core-js/es/set/difference.js";
import "core-js/es/set/intersection.js";
import "core-js/es/set/is-disjoint-from.js";
import "core-js/es/set/is-subset-of.js";
import "core-js/es/set/is-superset-of.js";
import "core-js/es/set/symmetric-difference.js";
import "core-js/es/set/union.js";
