<script lang="ts">
import Brand from '$lib/components/Brand.svelte'

let { data } = $props()
</script>

<main class="shell">
  <section class="card">
    <Brand />
    <h1>We could not continue</h1>
    <p>{data.message}</p>
    <p><a href="/">Return to Ensombl identity</a></p>
  </section>
</main>
