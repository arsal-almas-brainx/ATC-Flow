/**
 * A real percentage bar built from two <s-box>es — Polaris web components
 * have no dedicated progress-bar element, but <s-box>'s inlineSize accepts a
 * percentage, which is enough for an honest one.
 *
 * Deliberately has no animation/easing: the run's progress is only known at
 * each 1-second poll tick (see the polling effect in app._index.tsx), so
 * animating between ticks would imply a smoothness that isn't real.
 */
export function RunProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <s-stack direction="block" gap="small-200">
      <s-box background="subdued" borderRadius="base" blockSize="8px" inlineSize="100%">
        <s-box background="strong" borderRadius="base" blockSize="8px" inlineSize={`${pct}%`} />
      </s-box>
      <s-text color="subdued">{pct}%</s-text>
    </s-stack>
  );
}
