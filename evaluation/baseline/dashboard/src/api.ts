export async function fetchUser(id: number) {
  const res = await fetch('/api/users/' + id);
  return res.json();
}
export async function fetchEvents(id: number, month: string) {
  const res = await fetch('/api/events?user=' + id + '&month=' + month);
  return res.json();
}
export async function fetchTeams(id: number) {
  const res = await fetch('/api/teams?user=' + id);
  return res.json();
}
