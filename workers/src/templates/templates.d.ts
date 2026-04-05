declare module "*.html" {
  const content: string;
  export default content;
}

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.png" {
  const content: ArrayBuffer;
  export default content;
}

declare module "*.ico" {
  const content: ArrayBuffer;
  export default content;
}
