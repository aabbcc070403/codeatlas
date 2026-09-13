export function BioCard({ bio }: { bio: string }) {
  return <div className="bio">{bio}</div>
}

export function TagList({ tags }: { tags: string[] }) {
  return (
    <ul>
      {tags.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  )
}