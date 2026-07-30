<script lang="ts">
import Brand from '$lib/components/Brand.svelte'
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Global identity</h1>
    <p class="muted">
      Sign-in starts from your application. Account recovery and security settings remain
      available through this shared identity.
    </p>
    <div class="actions">
      <a class="secondary" href="/self-service/recovery/browser">Recover account</a>
      <a class="secondary" href="/self-service/settings/browser">Security settings</a>
      <a class="secondary" href="/ui/admin">Product administration</a>
    </div>
  </section>
</main>
