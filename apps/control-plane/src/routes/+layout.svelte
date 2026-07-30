<script lang="ts">
import '../app.css'

let { children, data } = $props()
</script>

<svelte:head>
  <title>{data.authBrand.displayName} identity</title>
  <meta
    name="description"
    content={`Secure sign-in and account management for ${data.authBrand.displayName}`}
  />
</svelte:head>

{@render children()}
