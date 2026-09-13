export interface User {
  id: string
  name: string
}

export function UserList({ users }: { users: User[] }) {
  return (
    <ul>
      {users.map((u) => (
        <li>{u.name}</li>
      ))}
    </ul>
  )
}