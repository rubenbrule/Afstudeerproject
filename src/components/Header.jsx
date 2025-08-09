import { Menu, Bell } from 'lucide-react';
import userLogo from '../assets/img/user3.png';

export default function Header() {
  return (
    <header className="w-full h-16 bg-white border-b flex items-center justify-between px-4 shadow-sm">
      {/* Linkerkant: Sidebar toggle en titel */}
      <div className="flex items-center space-x-4">
        <h1 className="text-xl font-semibold text-gray-800">Dashboard</h1>
      </div>

      {/* Rechterkant: Notificaties en Profiel */}
      <div className="flex items-center space-x-4">
        <button className="p-2 text-gray-500 hover:text-gray-700">
          <Menu size={20} />
        </button>
        <button className="p-2 text-gray-500 hover:text-gray-700">
          <Bell size={20} />
        </button>
        <img
          src={userLogo}
          alt="Gebruiker"
          className="w-9 h-9 rounded-full border-2 border-gray-200"
        />
      </div>
    </header>
  );
}

