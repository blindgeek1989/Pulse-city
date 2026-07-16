<script>
  import { captionStore } from '../stores.js';
</script>

<!--
  Visible caption bar for deaf/hard-of-hearing players.
  aria-hidden: screen readers use AccessibilityObserver's aria-live regions instead.
  pointer-events: none so it never blocks gameplay clicks.
-->
{#if $captionStore}
  <div
    class="caption-bar"
    aria-hidden="true"
    role="presentation"
  >
    <p class="caption-text">{$captionStore.text}</p>
  </div>
{/if}

<style>
  .caption-bar {
    position: fixed;
    bottom: 4rem; /* sits above the ScanBar */
    left: 50%;
    transform: translateX(-50%);
    width: max-content;
    max-width: min(70ch, calc(100vw - 2rem));
    padding: 0.5rem 1.25rem;
    background: rgba(0, 0, 0, 0.85);
    border-radius: 0.375rem;
    pointer-events: none;
    z-index: 20;
    animation: caption-in 180ms ease forwards;
  }

  .caption-text {
    color: #ffffff;
    font-size: 1.125rem;
    line-height: 1.5;
    font-weight: 500;
    text-align: center;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
    margin: 0;
  }

  @keyframes caption-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
</style>
