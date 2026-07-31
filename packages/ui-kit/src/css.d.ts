// ui-kit ships plain CSS side-effect imports (bundled by tsup at build time, and by the
// consuming app's own bundler at source-import time in tests/Storybook). This package
// doesn't otherwise depend on Vite, so it declares the ambient module itself rather than
// pulling in `vite/client` just for this one declaration.
declare module "*.css";
