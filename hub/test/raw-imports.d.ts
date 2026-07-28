declare module '*.jsonc?raw' {
  const source: string;
  export default source;
}

declare module '*.toml?raw' {
  const source: string;
  export default source;
}
