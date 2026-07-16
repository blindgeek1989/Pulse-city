<script>
  import { setContext, onMount, onDestroy } from 'svelte';
  import { syncScanStore, panelStore } from '../stores.js';
  import CaptionBar from './CaptionBar.svelte';
  import ScanBar from './ScanBar.svelte';
  import ControlPanel from './ControlPanel.svelte';

  let { a11y, input, announce, cbManager, speech } = $props();

  // Wrap in a closure so the context always forwards to the current prop value.
  setContext('announce', (...args) => announce(...args));

  // Poll InputManager scan state into scanStore every 100 ms.
  // InputManager has no event for scan advances (it's timer-driven),
  // so a lightweight poll is the cleanest bridge to Svelte's reactive stores.
  let syncTimer;

  onMount(() => {
    syncTimer = setInterval(() => syncScanStore(input), 100);
  });

  onDestroy(() => {
    clearInterval(syncTimer);
  });
</script>

<CaptionBar />
<ScanBar />
{#if $panelStore}
  <ControlPanel {cbManager} {speech} {input} {announce} />
{/if}
