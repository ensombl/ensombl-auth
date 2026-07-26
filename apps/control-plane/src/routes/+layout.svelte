<script lang="ts">
import '../app.css'

let { children } = $props()
</script>

<svelte:head>
  <title>Ensombl identity</title>
  <meta
    name="description"
    content="Secure sign-in and account management for Ensombl products"
  />
</svelte:head>

{@render children()}
