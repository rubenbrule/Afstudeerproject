import Sidebar from "./components/Sidebar";
import Header from "./components/Header";
import PrViewer from "./components/PrViewer";

function App() {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-col flex-1">
        <Header />
        <main className="p-6 bg-white flex-1 overflow-y-auto">
          {/* <h2 className="text-2xl font-bold mb-4">Welkom bij het feedbacksysteem</h2> */}
          <PrViewer />
        </main>
      </div>
    </div>
  );
}

export default App;