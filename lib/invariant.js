// src/invariant.ts
var PACKAGE_NAME = "@sidequest-007/dsh-atlas";
var name = "dsh-atlas-invariant";
var inject = ["invariants"];
var install = () => {
};
var apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
export {
  apply,
  inject,
  name
};
//# sourceMappingURL=invariant.js.map
