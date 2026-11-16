declare module "jsfive" {
  export type Attribute = number | string | number[] | null;
  export type AttributeMap = Record<string, Attribute>;
  export interface DataObjects {
    fh: ArrayBuffer;
    find_msg_type(type: number): Map<string, number>[];
    unpack_attribute(offset: number): [string, Attribute];
  }
  export class Dataset {
    shape: number[];
    dtype: string;
    attrs: AttributeMap;
    value: number[];
    _dataobjects: DataObjects;
  }
  export class File {
    constructor(buffer: ArrayBuffer, filename?: string);
    keys: string[];
    attrs: AttributeMap;
    get(name: string): Dataset;
  }
}
