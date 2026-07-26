<script lang="ts">
import Brand from '$lib/components/Brand.svelte'
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Invitation required</h1>
    <p class="muted">
      Ensombl accounts are created by invitation. If an administrator invited you, use the
      one-time recovery code sent to your email address.
    </p>
    <a class="secondary" href="/self-service/recovery/browser">Use invitation code</a>
  </section>
</main>
