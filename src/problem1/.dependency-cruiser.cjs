// Architecture rules for the three patterns. CI fails on any violation.
module.exports = {
  forbidden: [
    {
      name: 'core-is-pure',
      comment: 'Functional core: no IO, no frameworks, no other packages.',
      severity: 'error',
      from: { path: '^packages/core/src' },
      to: { pathNot: '^packages/core/src' },
    },
    {
      name: 'contracts-are-generated',
      comment: 'Contracts depend only on their runtimes.',
      severity: 'error',
      from: { path: '^packages/contracts/src' },
      to: { pathNot: ['^packages/contracts/src', 'node_modules/(@bufbuild/protobuf|kysely)/'] },
    },
    {
      name: 'codecs-map-contracts-to-core',
      severity: 'error',
      from: { path: '^packages/codecs/src' },
      to: {
        pathNot: ['^packages/(codecs|core|contracts)/src', 'node_modules/@bufbuild/protobuf/'],
      },
    },
    {
      name: 'platform-has-no-domain',
      comment: 'Shared infrastructure must not know about trading.',
      severity: 'error',
      from: { path: '^packages/platform/src' },
      to: { path: '^(packages/(core|contracts|codecs)|services)/' },
    },
    {
      name: 'app-layer-uses-ports-only',
      comment: 'Use cases talk to core and their own ports, never to adapters or infra.',
      severity: 'error',
      from: { path: '^services/([^/]+)/src/app/' },
      to: { pathNot: ['^services/$1/src/app/', '^packages/core/src'] },
    },
    {
      name: 'no-cross-service-imports',
      severity: 'error',
      from: { path: '^services/([^/]+)/' },
      to: { path: '^services/', pathNot: '^services/$1/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|test)/' },
    tsConfig: { fileName: 'tsconfig.check.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@exchange/source', 'import', 'types', 'default'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
