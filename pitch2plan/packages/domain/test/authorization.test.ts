import { describe, expect, it } from 'vitest';
import { canManage, canWrite } from '../src';

describe('role capabilities', () => {
  it('lets owners, admins and editors write; viewers cannot', () => {
    expect(['OWNER', 'ADMIN', 'EDITOR'].every((r) => canWrite(r as 'OWNER'))).toBe(true);
    expect(canWrite('VIEWER')).toBe(false);
  });
  it('restricts management to owners and admins', () => {
    expect(canManage('OWNER') && canManage('ADMIN')).toBe(true);
    expect(canManage('EDITOR') || canManage('VIEWER')).toBe(false);
  });
});
