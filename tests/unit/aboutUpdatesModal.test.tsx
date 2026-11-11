// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { AboutUpdatesModal } from "../../src/components/AboutUpdatesModal";

afterEach(() => cleanup());

function makeNetwork(response: any) {
  return {
    request: vi.fn(),
    get: vi.fn(async () => ({ ok: true, status: 200, data: response })),
    post: vi.fn(),
  } as any;
}

describe("AboutUpdatesModal", () => {
  it("renders installed build metadata", () => {
    const network = makeNetwork(null);
    render(<AboutUpdatesModal isOpen={true} onClose={() => {}} network={network} />);
    expect(screen.getByText(/Installed application/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Check for Updates/i })).toBeTruthy();
  });

  it("calls the update endpoint when checking", async () => {
    const network = makeNetwork({
      channel: "stable",
      installed: { version: "v0.9.0", commit: "unknown" },
      latest: null,
      status: "unknown",
      message: "Installed build identity is unknown; cannot confirm whether it is up to date.",
      checkedAt: new Date().toISOString(),
    });
    render(<AboutUpdatesModal isOpen={true} onClose={() => {}} network={network} />);
    fireEvent.click(screen.getByRole("button", { name: /Check for Updates/i }));
    await waitFor(() => expect(network.get).toHaveBeenCalled());
    expect(network.get).toHaveBeenCalledWith(expect.stringContaining("/api/update-check"));
  });
});
