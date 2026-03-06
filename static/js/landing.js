    var bootstrap=window.LectureProcessorBootstrap||{};
    var auth=bootstrap.getAuth?bootstrap.getAuth():firebase.auth();
    var topbarUtils=window.LectureProcessorTopbar||{};
    var dashboardBtnLabel=document.getElementById('dashboard-btn-label');
    if(topbarUtils.bindAuthCta){
      topbarUtils.bindAuthCta(auth,{
        labelEl:dashboardBtnLabel,
        linkEl:document.getElementById('dashboard-btn'),
        signedInText:'Dashboard',
        signedOutText:'Sign in',
        signedInHref:'/dashboard',
        signedOutHref:'/lecture-notes?auth=signin'
      });
    }else{
      auth.onAuthStateChanged(function(user){
        var dashboardBtn=document.getElementById('dashboard-btn');
        dashboardBtnLabel.textContent=user?'Dashboard':'Sign in';
        if(dashboardBtn){
          dashboardBtn.href=user?'/dashboard':'/lecture-notes?auth=signin';
        }
      });
    }
