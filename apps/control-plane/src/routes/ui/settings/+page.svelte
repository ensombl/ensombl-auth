<script lang="ts">
import Brand from '$lib/components/Brand.svelte'
import OryFlowForm from '$lib/components/OryFlowForm.svelte'

let { data } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>{data.forced ? 'Replace your password' : 'Security settings'}</h1>
    <p class="muted">
      {data.forced
        ? 'Your current password was migrated. Choose a different password before continuing.'
        : 'Manage your profile, password, and multi-factor authentication.'}
    </p>
    <OryFlowForm
      flow={data.flow}
      groups={data.forced ? ['password'] : ['profile', 'password', 'totp', 'lookup_secret']}
    />
  </section>
</main>
