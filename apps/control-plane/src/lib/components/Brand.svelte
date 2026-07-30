<script lang="ts">
import { page } from '$app/state'

const displayName = $derived(page.data.authBrand?.displayName ?? 'Ensombl')
const mark = $derived(displayName.slice(0, 1).toUpperCase())
</script>

<div class="brand"><span class="brand-mark">{mark}</span> {displayName}</div>
