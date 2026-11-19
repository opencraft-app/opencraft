"use strict";
const PRESENTATION_VERSION = 1;
const THUMBNAIL_LIMIT = 360000,
  FAVICON_LIMIT = 24000;
function raster(value, limit) {
  return typeof value === "string" &&
    value.length <= limit &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
    ? value
    : null;
}
function readPresentation(value) {
  if (
    !value ||
    value.version !== PRESENTATION_VERSION ||
    typeof value.document !== "string" ||
    value.document.length > 100 ||
    typeof value.revision !== "string" ||
    value.revision.length > 100
  )
    return null;
  return {
    version: PRESENTATION_VERSION,
    document: value.document,
    revision: value.revision,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    thumbnail: raster(value.thumbnail, THUMBNAIL_LIMIT),
    favicon: raster(value.favicon, FAVICON_LIMIT),
  };
}
module.exports = { PRESENTATION_VERSION, THUMBNAIL_LIMIT, FAVICON_LIMIT, readPresentation };
