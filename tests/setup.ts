if (!("window" in globalThis)) {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}
