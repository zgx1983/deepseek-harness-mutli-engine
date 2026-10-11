/** Theme-token styles for the project usage dashboard. */
export const CSS = `
.pa-dashboard { box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; width: 100%; height: 100%; min-height: 0; overflow-y: auto; padding: 24px clamp(18px, 4vw, 48px) 28px; color: var(--dsw-alias-label-primary); scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l2) transparent; }
.pa-dashboard-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
.pa-dashboard-head h1 { margin: 0; font-size: 20px; line-height: 1.35; font-weight: 500; }
.pa-dashboard-head p { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.pa-dashboard-actions { display: flex; align-items: center; gap: 8px; }
.pa-period { display: inline-flex; padding: 3px; gap: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); }
.pa-period button, .pa-refresh, .pa-dashboard-error button { border: 0; border-radius: 6px; padding: 6px 10px; color: var(--dsw-alias-label-secondary); background: transparent; font: inherit; font-size: 12px; cursor: pointer; }
.pa-period button[aria-pressed='true'] { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); box-shadow: 0 1px 3px var(--dsw-alias-border-l1); }
.pa-refresh { border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
.pa-refresh:hover, .pa-dashboard-error button:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-1)); }
.pa-refresh:disabled { cursor: default; opacity: .6; }
.pa-dashboard-error, .pa-dashboard-note { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-secondary)); font-size: 12px; }
.pa-dashboard-note { color: var(--dsw-alias-label-secondary); }
.pa-dashboard-error button { color: var(--dsw-alias-label-primary); }
.pa-metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.pa-metric { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.pa-metric > span { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.pa-metric > strong { overflow: hidden; text-overflow: ellipsis; font-size: clamp(21px, 3vw, 28px); line-height: 1.2; font-weight: 500; font-variant-numeric: tabular-nums; }
.pa-metric > small { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11px; line-height: 1.45; }
.pa-dashboard-section { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.pa-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.pa-section-heading h2 { margin: 0; font-size: 14px; font-weight: 500; }
.pa-section-heading > span { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11px; }
.pa-usage-chart { display: flex; align-items: stretch; gap: 10px; height: 150px; padding: 8px 8px 0; border-bottom: 1px solid var(--dsw-alias-border-l1); }
.pa-usage-hours { gap: 3px; }
.pa-usage-hours .pa-usage-track { width: 100%; }
.pa-usage-day { display: grid; grid-template-rows: 20px minmax(0, 1fr) 24px; flex: 1; min-width: 0; justify-items: center; align-items: end; }
.pa-usage-value { max-width: 100%; overflow: hidden; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.pa-usage-track { display: flex; align-items: end; justify-content: center; width: min(100%, 44px); height: 100%; }
.pa-usage-bar { width: 100%; min-height: 3px; border-radius: 5px 5px 0 0; background: var(--dsw-alias-brand-primary, var(--dsw-alias-label-secondary)); opacity: .76; }
.pa-usage-label { align-self: center; color: var(--dsw-alias-label-secondary); font-size: 10px; white-space: nowrap; }
.pa-project-list, .pa-session-list { display: flex; flex-direction: column; min-width: 0; }
.pa-project-row, .pa-session-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-width: 0; padding: 10px 2px; border-top: 1px solid var(--dsw-alias-border-l1); }
.pa-project-name, .pa-project-tokens, .pa-session-main, .pa-session-tokens { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pa-project-name strong, .pa-session-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.pa-project-name span, .pa-project-tokens span, .pa-session-main span, .pa-session-tokens span { overflow: hidden; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.pa-project-tokens span, .pa-session-tokens span { max-width: min(50vw, 480px); overflow: visible; overflow-wrap: anywhere; white-space: normal; }
.pa-project-tokens, .pa-session-tokens { flex: none; align-items: flex-end; text-align: right; }
.pa-project-tokens strong, .pa-session-tokens strong { font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
.pa-session-row { padding-block: 9px; }
.pa-empty { margin: 0; padding: 18px 8px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); text-align: center; font-size: 12px; }
.pa-dashboard-loading { display: grid; flex: 1; min-height: 160px; place-items: center; }
.pa-dashboard-loading span { width: 22px; height: 22px; border: 2px solid var(--dsw-alias-border-l1); border-top-color: var(--dsw-alias-label-secondary); border-radius: 50%; animation: pa-spin .8s linear infinite; }
@keyframes pa-spin { to { transform: rotate(360deg); } }
.pa-dashboard-foot { padding-top: 2px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 10px; text-align: right; }
@media (max-width: 680px) { .pa-dashboard { gap: 16px; padding-inline: 16px; } .pa-metrics { grid-template-columns: 1fr 1fr; } .pa-metric:last-child { grid-column: 1 / -1; } }
@media (max-width: 420px) { .pa-dashboard-head { align-items: flex-start; flex-direction: column; } .pa-dashboard-actions { width: 100%; justify-content: space-between; } .pa-metrics { gap: 8px; } .pa-metric { padding: 12px; } }
@media (prefers-reduced-motion: reduce) { .pa-dashboard-loading span { animation: none; } }
`
