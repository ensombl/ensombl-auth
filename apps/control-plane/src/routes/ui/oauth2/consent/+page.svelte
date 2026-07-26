<script lang="ts">
import Brand from '$lib/components/Brand.svelte'

let { data } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Allow {data.clientName}?</h1>
    <p class="muted">This application is requesting the following access:</p>
    <ul class="scope-list">
      {#each data.scopes as scope}
        <li>{scope}</li>
      {/each}
    </ul>
    <div class="actions">
      <form method="POST" action="?/approve">
        <input type="hidden" name="challenge" value={data.challenge} />
        <button class="primary" type="submit">Allow</button>
      </form>
      <form method="POST" action="?/deny">
        <input type="hidden" name="challenge" value={data.challenge} />
        <button class="danger" type="submit">Deny</button>
      </form>
    </div>
  </section>
</main>
