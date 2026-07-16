<script>
  import { onMount, onDestroy } from 'svelte';
  import { FrameBudget } from '../engine/PerformanceMonitor.js';

  let { perf } = $props();

  let visible = $state(false);
  let fps     = $state(0);
  let frameMs = $state(0);
  let budget  = $state(FrameBudget.GOOD);
  let minMs   = $state(0);
  let maxMs   = $state(0);

  let unsub;

  const BUDGET_COLOR = {
    [FrameBudget.GOOD]:     '#00f5ff',  // neon cyan — on-budget
    [FrameBudget.WARNING]:  '#f5c000',  // amber — dipping below 60 fps
    [FrameBudget.CRITICAL]: '#ff3333',  // red — below 30 fps
  };

  onMount(() => {
    unsub = perf.onUpdate(() => {
      fps     = perf.fps;
      frameMs = perf.frameMs;
      budget  = perf.budget;
      minMs   = perf.min;
      maxMs   = perf.max;
    });

    function onKeydown(e) {
      if (e.key === '`' || e.key === 'F3') {
        e.preventDefault();
        visible = !visible;
      }
    }

    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  onDestroy(() => {
    unsub?.();
  });
</script>

<!--
  Dev-only frame budget overlay.
  aria-hidden: this is a developer tool, not part of gameplay.
  Toggle with backtick (`) or F3.
-->
{#if visible}
  <div class="perf-hud" aria-hidden="true">
    <span class="fps" style:color={BUDGET_COLOR[budget]}>
      {fps.toFixed(0)} fps
    </span>
    <span class="detail">{frameMs.toFixed(2)} ms avg</span>
    <span class="detail range">↓{minMs.toFixed(1)} ↑{maxMs.toFixed(1)} ms</span>
  </div>
{/if}

<style>
  .perf-hud {
    position: fixed;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 60;
    background: rgba(0, 0, 0, 0.75);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 4px;
    padding: 0.25rem 0.625rem;
    font-family: 'Courier New', monospace;
    font-size: 0.75rem;
    line-height: 1.6;
    display: flex;
    flex-direction: column;
    gap: 0;
    pointer-events: none;
    user-select: none;
  }

  .fps {
    font-weight: 700;
    font-size: 0.875rem;
  }

  .detail {
    color: rgba(255, 255, 255, 0.55);
  }
</style>
