<script lang="ts">
import Brand from '$lib/components/Brand.svelte'

let { data, form } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Invite a {data.product} user</h1>
    <p class="muted">A recovery code is sent first. Product access activates after recovery.</p>
    {#if form?.ok}
      <p>Invitation {form.invitationId} is {form.state}.</p>
    {:else if form?.error}
      <p class="error">{form.error}</p>
    {/if}
    <form method="POST">
      <input type="hidden" name="product" value={data.product} />
      <input
        type="hidden"
        name="idempotency_key"
        value={form?.nextIdempotencyKey ?? data.idempotencyKey}
      />
      <label>
        Email
        <input name="email" type="email" autocomplete="off" required maxlength="320" />
      </label>
      <label>
        Invitation validity in hours
        <input name="expires_in_hours" type="number" min="1" max="168" value="48" required />
      </label>
      <button type="submit">Send invitation</button>
    </form>
  </section>
</main>
