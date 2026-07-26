<script lang="ts">
import Brand from '$lib/components/Brand.svelte'

let { data } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Sign out of {data.clientName}?</h1>
    <p class="muted">
      This ends your session with {data.clientName}. Your Ensombl identity session remains active
      for other products.
    </p>
    <div class="actions">
      <form method="POST" action="?/confirm">
        <input type="hidden" name="challenge" value={data.challenge} />
        <button class="danger" type="submit">Sign out</button>
      </form>
      <form method="POST" action="?/cancel">
        <input type="hidden" name="challenge" value={data.challenge} />
        <button class="secondary" type="submit">Cancel</button>
      </form>
    </div>
  </section>
</main>
