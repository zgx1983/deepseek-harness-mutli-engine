/** Recent section styles; class names are static (no CSS modules in this bundle). */
export const CSS = `
.rs-section { flex: 0 1 auto; min-height: 0; display: flex; flex-direction: column; margin-bottom: 8px; overflow: hidden; }
.rs-header { display: flex; align-items: center; gap: 6px; flex: none; border: none; border-radius: var(--dsw-radius-md); padding: 0 8px; height: 32px; background: transparent; cursor: pointer; user-select: none; color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; text-align: left; width: 100%; }
.rs-header:hover { background: var(--dsw-alias-interactive-bg-hover); }
.rs-chevron { display: flex; align-items: center; justify-content: center; flex: none; width: 16px; color: var(--dsw-alias-label-caption); }
.rs-arrow { transition: transform 150ms var(--ds-ease-in-out); }
.rs-arrow-open { transform: rotate(90deg); }
.rs-row { display: flex; align-items: center; gap: 4px; width: 100%; flex: none; border: none; border-radius: var(--dsw-radius-md); padding: 0 8px; height: 32px; background: transparent; cursor: pointer; user-select: none; color: var(--dsw-alias-label-primary); text-align: left; }
.rs-row:hover, .rs-row-selected { background: var(--dsw-alias-interactive-bg-hover); }
.rs-dot-cell { display: flex; align-items: center; justify-content: center; flex: none; width: 16px; }
.rs-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; line-height: 20px; }
.rs-project { display: inline-block; vertical-align: bottom; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-trailing { flex: none; margin-left: auto; padding-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; line-height: 17px; color: var(--dsw-alias-label-tertiary); }
.rs-overflow { display: block; width: 100%; flex: none; border: none; border-radius: var(--dsw-radius-md); padding: 0 8px 0 28px; height: 28px; background: transparent; cursor: pointer; text-align: left; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
.rs-overflow:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
@media (prefers-reduced-motion: reduce) { .rs-arrow { animation: none; transition: none; } }
`
