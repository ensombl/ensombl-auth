<script lang="ts">
import Brand from '$lib/components/Brand.svelte'
import OryFlowForm from '$lib/components/OryFlowForm.svelte'

let { data } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>Verify your address</h1>
    <p class="muted">Enter the code sent to your email address.</p>
    <OryFlowForm flow={data.flow} groups={['code', 'link']} />
  </section>
</main>
