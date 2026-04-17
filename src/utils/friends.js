/**
 * Returns [userIdA, userIdB] in canonical order (lexicographically lower first).
 * This guarantees exactly one row per friendship pair in the DB.
 */
function canonicalPair(idX, idY) {
  return idX < idY ? [idX, idY] : [idY, idX];
}

module.exports = { canonicalPair };
