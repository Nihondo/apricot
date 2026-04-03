declare module "encoding-japanese" {
  type EncodingName =
    | "UTF32" | "UTF16" | "UTF16BE" | "UTF16LE" | "BINARY" | "ASCII"
    | "JIS" | "UTF8" | "EUCJP" | "SJIS" | "UNICODE";

  interface ConvertOptions {
    to: EncodingName;
    from?: EncodingName | "AUTO";
    type?: "array" | "string" | "arraybuffer";
  }

  function convert(data: number[], options: ConvertOptions): number[];
  function stringToCode(str: string): number[];
  function codeToString(codes: number[]): string;
  function detect(data: number[] | Uint8Array | string, encodings?: EncodingName | EncodingName[] | "AUTO"): EncodingName | false;
}
