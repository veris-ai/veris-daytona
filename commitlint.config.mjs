// Enforced by the `commits` job in .github/workflows/ci.yml, against the PR
// title -- see the comment there for why the title and not the commits.
//
// .mjs, not .js: the root package.json has no "type": "module", so a bare .js
// config would be loaded as CommonJS and the `export default` below would be a
// syntax error.
export default {
  extends: ['@commitlint/config-conventional'],
}
