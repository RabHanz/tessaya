declare module "@t3tools/mobile-stage-stream" {
  const script: string;
  export default script;
}

// the companion's plain scripts, inlined into the Sleeve stage's WebView bundle
declare module "*.js?raw" {
  const source: string;
  export default source;
}
