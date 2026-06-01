import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Users, ShieldCheck, User } from "lucide-react";

interface AppUser {
  id: number;
  username: string;
  role: string;
  isActive: boolean;
  createdAt: string;
}

interface UserForm {
  username: string;
  password: string;
  role: string;
}

const emptyForm: UserForm = { username: '', password: '', role: 'user' };

export default function UsersPage() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [form, setForm] = useState<UserForm>(emptyForm);

  const { data, isLoading } = useQuery<{ users: AppUser[] }>({
    queryKey: ['/api/users'],
    queryFn: async () => {
      const res = await fetch('/api/users', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch users');
      return res.json();
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (values: UserForm) => {
      const url = editing ? `/api/users/${editing.id}` : '/api/users';
      const method = editing ? 'PATCH' : 'POST';
      const body: any = { role: values.role };
      if (values.username) body.username = values.username;
      if (values.password) body.password = values.password;
      const res = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save user');
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/users'] });
      setDialogOpen(false);
      setEditing(null);
      setForm(emptyForm);
      toast({ title: editing ? 'User updated' : 'User created' });
    },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const toggleActive = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      const res = await fetch(`/api/users/${id}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      if (!res.ok) throw new Error('Failed to update user');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/api/users'] }),
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/users/${id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error('Failed to delete user');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['/api/users'] });
      toast({ title: 'User deleted' });
    },
    onError: (e: any) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const openCreate = () => { setEditing(null); setForm(emptyForm); setDialogOpen(true); };
  const openEdit = (u: AppUser) => { setEditing(u); setForm({ username: u.username, password: '', role: u.role }); setDialogOpen(true); };

  const users = data?.users || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2"><Users className="h-7 w-7" /> User Management</h1>
          <p className="text-muted-foreground mt-1">Create and manage user accounts</p>
        </div>
        <Button onClick={openCreate} className="gap-2">
          <Plus className="h-4 w-4" /> Add User
        </Button>
      </div>

      <div className="grid gap-4">
        {isLoading ? (
          <p className="text-muted-foreground">Loading users...</p>
        ) : users.length === 0 ? (
          <p className="text-muted-foreground">No users found.</p>
        ) : users.map(u => (
          <Card key={u.id} className={!u.isActive ? 'opacity-60' : ''}>
            <CardContent className="flex items-center justify-between py-4">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center">
                  {u.role === 'admin' ? <ShieldCheck className="h-5 w-5 text-blue-500" /> : <User className="h-5 w-5 text-muted-foreground" />}
                </div>
                <div>
                  <p className="font-medium">{u.username} {u.id === me?.id && <span className="text-xs text-muted-foreground">(you)</span>}</p>
                  <p className="text-xs text-muted-foreground">Created {new Date(u.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant={u.role === 'admin' ? 'default' : 'secondary'}>{u.role}</Badge>
                <Badge variant={u.isActive ? 'outline' : 'destructive'}>{u.isActive ? 'Active' : 'Inactive'}</Badge>
                <Button variant="ghost" size="icon" onClick={() => openEdit(u)}><Pencil className="h-4 w-4" /></Button>
                {u.id !== me?.id && (
                  <>
                    <Button variant="ghost" size="icon" onClick={() => toggleActive.mutate({ id: u.id, isActive: !u.isActive })}>
                      {u.isActive ? <span className="text-xs text-yellow-600">Disable</span> : <span className="text-xs text-green-600">Enable</span>}
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => deleteMutation.mutate(u.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit User' : 'Create User'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={e => { e.preventDefault(); saveMutation.mutate(form); }} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} required={!editing} placeholder="Enter username" />
            </div>
            <div className="space-y-1.5">
              <Label>{editing ? 'New Password (leave blank to keep)' : 'Password'}</Label>
              <Input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} required={!editing} placeholder={editing ? 'Leave blank to keep current' : 'Enter password'} />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="user">User</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? 'Saving...' : editing ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
