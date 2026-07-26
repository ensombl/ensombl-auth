<script lang="ts">
import Brand from '$lib/components/Brand.svelte'
import OryFlowForm from '$lib/components/OryFlowForm.svelte'

let { data } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Recover your account</h1>
    <p class="muted">We will send a one-time recovery code to the verified address.</p>
    <OryFlowForm flow={data.flow} groups={['code', 'link']} />
  </section>
</main>
