declare module "cytoscape-fcose" {
  const ext: import("cytoscape").Ext;
  export default ext;
}

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
