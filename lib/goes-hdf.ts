import type { AttributeMap, Dataset } from "jsfive";

/** jsfive 0.4.2 reads data but not dense HDF5 attributes. Resolve the actual
 * name-index / managed-heap addresses, then reuse its attribute decoder.
 * Supports NOAA's leaf attribute indexes and direct heap blocks, including
 * blocks reached through one indirect table. Other layouts fail explicitly.
 * Format: https://portal.hdfgroup.org/documentation/hdf5/latest/_f_m_t3.html
 */
export function readGoesAttributes(dataset: Dataset, wanted?: Set<string>): AttributeMap {
  const result = { ...dataset.attrs };
  const objects = dataset._dataobjects;
  const buffer = objects.fh;
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const check = (offset: number, length: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > buffer.byteLength) {
      throw new Error("Invalid HDF5 metadata address.");
    }
  };
  const uint = (offset: number, length: number): number => {
    check(offset, length);
    let value = 0;
    for (let i = 0; i < length; i++) value += bytes[offset + i] * 2 ** (8 * i);
    if (!Number.isSafeInteger(value)) throw new Error("Unsupported HDF5 metadata integer.");
    return value;
  };
  const signature = (offset: number, expected: string) => {
    check(offset, expected.length);
    if (!Array.from(expected).every((c, i) => bytes[offset + i] === c.charCodeAt(0))) {
      throw new Error(`Invalid HDF5 ${expected} block.`);
    }
  };

  for (const message of objects.find_msg_type(0x15)) {
    const info = message.get("offset_to_message")!;
    check(info, 4);
    if (bytes[info] !== 0) throw new Error("Unsupported HDF5 attribute-info version.");
    const pointers = info + 2 + ((bytes[info + 1] & 1) ? 2 : 0);
    // An undefined heap address means attributes are still compact.
    if (bytes.slice(pointers, pointers + 8).every((b) => b === 255)) continue;
    const heap = uint(pointers, 8);
    const tree = uint(pointers + 8, 8);
    signature(heap, "FRHP");
    signature(tree, "BTHD");
    check(heap, 146);
    check(tree, 38);
    if (bytes[heap + 4] !== 0 || view.getUint16(heap + 7, true) !== 0 ||
        bytes[tree + 4] !== 0 || bytes[tree + 5] !== 8 || view.getUint16(tree + 12, true) !== 0) {
      throw new Error("Unsupported NOAA HDF5 dense-attribute layout.");
    }
    const idSize = view.getUint16(heap + 5, true);
    const offsetSize = Math.ceil(view.getUint16(heap + 128, true) / 8);
    const lengthSize = idSize - 1 - offsetSize;
    if (offsetSize < 1 || offsetSize > 6 || lengthSize < 1 || lengthSize > 4) {
      throw new Error("Unsupported HDF5 managed-heap ID.");
    }
    const root = uint(heap + 132, 8);
    const rows = view.getUint16(heap + 140, true);
    const startingSize = uint(heap + 112, 8);
    const maximumDirect = uint(heap + 120, 8);
    const blocks: { file: number; logical: number; size: number }[] = [];
    const addBlock = (file: number, size: number) => {
      signature(file, "FHDB");
      if (uint(file + 5, 8) !== heap) throw new Error("HDF5 heap ownership mismatch.");
      check(file, size);
      blocks.push({ file, size, logical: uint(file + 13, offsetSize) });
    };
    if (rows === 0) addBlock(root, startingSize);
    else {
      signature(root, "FHIB");
      const width = view.getUint16(heap + 110, true);
      const directRows = Math.log2(maximumDirect / startingSize) + 2;
      if (rows > directRows || width > 64 || rows > 32) {
        throw new Error("Unsupported nested HDF5 attribute heap.");
      }
      for (let row = 0; row < rows; row++) {
        const size = startingSize * 2 ** Math.max(0, row - 1);
        for (let col = 0; col < width; col++) {
          const at = root + 13 + offsetSize + (row * width + col) * 8;
          if (bytes.slice(at, at + 8).every((b) => b === 255)) continue;
          addBlock(uint(at, 8), size);
        }
      }
    }
    const leaf = uint(tree + 16, 8);
    const count = view.getUint16(tree + 24, true);
    const recordSize = view.getUint16(tree + 10, true);
    signature(leaf, "BTLF");
    if (recordSize !== idSize + 9 || count > 1000) throw new Error("Unsupported HDF5 attribute record.");
    for (let index = 0; index < count; index++) {
      const record = leaf + 6 + index * recordSize;
      check(record, recordSize);
      if (bytes[record] !== 0 || bytes[record + idSize] !== 0) {
        throw new Error("Unsupported shared or non-managed HDF5 attribute.");
      }
      const logical = uint(record + 1, offsetSize);
      const length = uint(record + 1 + offsetSize, lengthSize);
      const block = blocks.find((b) => logical >= b.logical && logical + length <= b.logical + b.size);
      if (!block) throw new Error("HDF5 attribute falls outside its heap.");
      const address = block.file + logical - block.logical;
      if (wanted && bytes[address] === 3) {
        const nameSize = view.getUint16(address + 2, true);
        check(address + 9, nameSize);
        const name = new TextDecoder().decode(bytes.subarray(address + 9, address + 9 + nameSize)).replace(/\0$/, "");
        if (!wanted.has(name)) continue;
      }
      const [name, value] = objects.unpack_attribute(address);
      result[name] = value;
    }
  }
  return result;
}

export function numericAttribute(attributes: AttributeMap, name: string): number {
  const raw = attributes[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Missing NOAA metadata: ${name}.`);
  return value;
}
