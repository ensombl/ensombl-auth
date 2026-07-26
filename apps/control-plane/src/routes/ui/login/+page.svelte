<script lang="ts">
import Brand from '$lib/components/Brand.svelte'
import OryFlowForm from '$lib/components/OryFlowForm.svelte'

let { data } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Sign in</h1>
    <p class="muted">Use your global Ensombl identity.</p>
    <OryFlowForm flow={data.flow} groups={['password', 'totp', 'lookup_secret', 'code']} />
    <p><a href="/self-service/recovery/browser">Forgot your password?</a></p>
  </section>
</main>
