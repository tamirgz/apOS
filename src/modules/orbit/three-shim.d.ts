// three@0.185 ships no resolvable type declarations in this pnpm layout, and we
// only ever touch it through `any` helpers (halo sprites on the semantic map).
// Declaring the module as untyped silences TS7016 without pulling @types/three.
declare module "three";
