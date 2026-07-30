<script lang="ts">
import Brand from '$lib/components/Brand.svelte'

let { data } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Product administration</h1>
    <p class="muted">Select a product you administer.</p>
    <div class="actions">
      {#each data.products as product}
        <a class="secondary" href={`/admin/invitations?product=${encodeURIComponent(product.id)}`}>
          {product.displayName}
        </a>
      {/each}
    </div>
    <p class="muted">Administrative actions require multi-factor authentication.</p>
    <p><a href="/self-service/settings/browser">Security settings</a></p>
  </section>
</main>
