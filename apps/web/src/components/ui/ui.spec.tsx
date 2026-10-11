import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';
import { ThemeToggle } from '../theme-toggle';

describe('ui primitives', () => {
  it('primary button is focusable and fires onClick by keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Kaydet</Button>);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Kaydet' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });
  it('theme toggle switches data-theme and persists', async () => {
    document.documentElement.dataset.theme = 'dark';
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: /tema/i }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /açık/i }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });
});
