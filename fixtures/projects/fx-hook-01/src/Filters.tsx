import { useState } from 'react'

export function Filters({ items }: { items: string[] }) {
  const [query, setQuery] = useState('')
  if (items.length > 10) {
    const [page, setPage] = useState(1)
    void setPage
  }
  return <input value={query} onChange={(e) => setQuery(e.target.value)} />
}