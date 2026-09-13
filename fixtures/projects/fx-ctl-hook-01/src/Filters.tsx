import { useState } from 'react'

export function Filters({ items }: { items: string[] }) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const showPager = items.length > 10
  void setPage
  void showPager
  return <input value={query} onChange={(e) => setQuery(e.target.value)} />
}