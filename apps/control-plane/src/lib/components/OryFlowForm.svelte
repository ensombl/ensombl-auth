<script lang="ts">
import type { KratosFlow, UiNode } from '$lib/server/types'

let {
  flow,
  groups,
}: {
  flow: KratosFlow
  groups?: string[]
} = $props()

const included = (node: UiNode): boolean =>
  !groups || node.group === 'default' || groups.includes(node.group)

const input = (node: UiNode) =>
  node.attributes.node_type === 'input' ? node.attributes : undefined
</script>

{#if flow.ui.messages?.length}
  <ul class="messages" aria-live="polite">
    {#each flow.ui.messages as message}
      <li class="message">{message.text}</li>
    {/each}
  </ul>
{/if}

<form action={flow.ui.action} method={flow.ui.method}>
  {#each flow.ui.nodes.filter(included) as node}
    {@const attributes = input(node)}
    {#if attributes?.type === 'hidden'}
      <input name={attributes.name} type="hidden" value={String(attributes.value ?? '')} />
    {:else if attributes?.type === 'submit'}
      <button
        class="primary"
        type="submit"
        name={attributes.name}
        value={String(attributes.value ?? '')}
        disabled={attributes.disabled}
      >
        {node.meta.label?.text ?? 'Continue'}
      </button>
    {:else if attributes}
      <div class="field">
        <label for={`${flow.id}-${attributes.name}`}>{node.meta.label?.text ?? attributes.name}</label>
        <input
          id={`${flow.id}-${attributes.name}`}
          name={attributes.name}
          type={attributes.type}
          value={typeof attributes.value === 'string' || typeof attributes.value === 'number'
            ? attributes.value
            : ''}
          required={attributes.required}
          disabled={attributes.disabled}
          autocomplete={attributes.autocomplete}
        />
        {#if node.messages?.length}
          <ul class="messages" aria-live="polite">
            {#each node.messages as message}
              <li class="message">{message.text}</li>
            {/each}
          </ul>
        {/if}
      </div>
    {:else if node.attributes.node_type === 'a'}
      <p><a href={node.attributes.href}>{node.meta.label?.text ?? node.attributes.title?.text}</a></p>
    {:else if node.attributes.node_type === 'img'}
      <img
        src={node.attributes.src}
        alt={node.meta.label?.text ?? ''}
        height={node.attributes.height}
        width={node.attributes.width}
      />
    {:else if node.attributes.node_type === 'text'}
      <p>{node.attributes.text.text}</p>
    {/if}
  {/each}
</form>
