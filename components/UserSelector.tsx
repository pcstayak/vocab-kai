'use client'

import React, { useState, useEffect } from 'react'
import { getAllUsers, createUser, type User } from '../lib/db-operations'

interface UserSelectorProps {
  onUserSelected: (userId: string) => void
}

export default function UserSelector({ onUserSelected }: UserSelectorProps) {
  const [users, setUsers] = useState<User[]>([])
  const [newUserName, setNewUserName] = useState('')
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadUsers()
  }, [])

  async function loadUsers() {
    try {
      setLoading(true)
      setError(null)
      const data = await getAllUsers()
      setUsers(data)
    } catch (err) {
      setError('Failed to load users. Please check your Supabase connection.')
      console.error('Error loading users:', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateUser() {
    const name = newUserName.trim()
    if (!name) return

    try {
      setCreating(true)
      setError(null)
      const userId = await createUser(name)

      // Save to localStorage and notify parent
      localStorage.setItem('selectedUserId', userId)
      onUserSelected(userId)
    } catch (err) {
      setError('Failed to create user. Please try again.')
      console.error('Error creating user:', err)
    } finally {
      setCreating(false)
    }
  }

  function handleSelectUser(userId: string) {
    localStorage.setItem('selectedUserId', userId)
    onUserSelected(userId)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="text-center">
          <div className="mb-4 text-lg font-semibold">Loading users...</div>
          <div className="text-sm text-slate-400">Connecting to Supabase</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
        <div className="max-w-md rounded-2xl border border-rose-900/40 bg-rose-950/20 p-6">
          <div className="mb-3 text-lg font-semibold text-rose-200">Connection Error</div>
          <div className="mb-4 text-sm text-rose-200/80">{error}</div>
          <button
            onClick={loadUsers}
            className="rounded-xl bg-rose-400 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-rose-300"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="mb-8 text-center">
          <div className="mb-2 inline-block rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
            <div className="text-3xl font-bold">SRS Vocab Trainer</div>
          </div>
          <div className="mt-4 text-slate-300">Select a user to continue</div>
        </div>

        {users.length > 0 && (
          <div className="mb-8">
            <div className="mb-4 text-sm font-semibold text-slate-300">Existing Users</div>
            <div className="grid gap-3 sm:grid-cols-2">
              {users.map((user) => (
                <button
                  key={user.id}
                  onClick={() => handleSelectUser(user.id)}
                  className="rounded-2xl border border-slate-800 bg-slate-900/30 p-5 text-left transition hover:bg-slate-900/50 hover:border-slate-700"
                >
                  <div className="text-lg font-semibold">{user.name}</div>
                  <div className="mt-1 text-xs text-slate-400">
                    Joined {new Date(user.created_at).toLocaleDateString()}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-6">
          <div className="mb-4 text-sm font-semibold text-slate-300">Add New User</div>
          <div className="flex gap-3">
            <input
              type="text"
              value={newUserName}
              onChange={(e) => setNewUserName(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleCreateUser()}
              placeholder="Enter name"
              disabled={creating}
              className="flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 py-2 text-sm text-slate-100 placeholder:text-slate-500 outline-none focus:border-slate-400 disabled:opacity-50"
            />
            <button
              onClick={handleCreateUser}
              disabled={!newUserName.trim() || creating}
              className="rounded-xl bg-emerald-400 px-6 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
          <div className="mt-3 text-xs text-slate-400">
            No validation required - just enter a name to get started
          </div>
        </div>

        {users.length === 0 && !creating && (
          <div className="mt-6 text-center text-sm text-slate-400">
            No users yet. Create your first user to get started!
          </div>
        )}
      </div>
    </div>
  )
}
