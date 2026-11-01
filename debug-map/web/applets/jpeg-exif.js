// A SpiriCamera frame's tags, read out of the JPEG itself: the camera writes
// them as JSON into EXIF's UserComment (SpiriCamera's exif.py), so they can't
// be read against the wrong frame. Never throws; a frame with no tags, or
// damaged ones, has none.

const ASCII_PREFIX = "ASCII\0\0\0";
const EXIF_IFD = 0x8769;
const USER_COMMENT = 0x9286;
const decoder = new TextDecoder();

export function exifTags(bytes) {
  try {
    const comment = userComment(bytes);
    if (!comment?.startsWith(ASCII_PREFIX)) return {};
    const tags = JSON.parse(comment.slice(ASCII_PREFIX.length));
    if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};
    return Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

function userComment(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0) !== 0xffd8) return null;
  // Segments up to the image data: FF <marker> <length, including itself>.
  for (let at = 2; at + 4 <= bytes.length; ) {
    const marker = view.getUint16(at);
    if (marker === 0xffda || (marker & 0xff00) !== 0xff00) return null;
    const length = view.getUint16(at + 2);
    if (marker === 0xffe1 && decoder.decode(bytes.subarray(at + 4, at + 10)) === "Exif\0\0") {
      return fromTiff(view, at + 10);
    }
    at += 2 + length;
  }
  return null;
}

// The UserComment in a TIFF block's Exif IFD, as text.
function fromTiff(view, tiff) {
  const little = view.getUint16(tiff) === 0x4949; // "II"
  const u16 = (at) => view.getUint16(tiff + at, little);
  const u32 = (at) => view.getUint32(tiff + at, little);
  const entry = (ifd, tag) => {
    for (let i = 0, n = u16(ifd); i < n; i++) {
      const at = ifd + 2 + i * 12;
      if (u16(at) === tag) return { count: u32(at + 4), value: at + 8 };
    }
    return null;
  };
  const exif = entry(u32(4), EXIF_IFD);
  if (!exif) return null;
  const comment = entry(u32(exif.value), USER_COMMENT);
  if (!comment) return null;
  // Over four bytes, the value is somewhere else and this is where.
  const start = tiff + (comment.count > 4 ? u32(comment.value) : comment.value);
  return decoder.decode(new Uint8Array(view.buffer, view.byteOffset + start, comment.count));
}
